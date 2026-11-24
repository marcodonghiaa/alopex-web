import { addDays, formatISODate } from "@/lib/date";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DEMO_USER_ID, PERIOD_DAYS, generateDemoData, type DemoDb } from "./generate";
import { demoHoldingPerformance } from "./performance";
import { deriveViews } from "./views";
import { onDemoExit } from "./mode";
import { ACCOUNT_TYPES, isDebt } from "@/lib/account-types";
import { CATEGORIES } from "@/lib/categories";

// A stand-in for the Supabase client that answers from generated, in-memory data. It makes no
// network calls at all, and every write lives only in this object: a reload starts over.

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;
type Mode = "select" | "insert" | "update" | "upsert" | "delete";
interface Result {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}

const DISABLED = { message: "Disabled in the demo." };
// Tables a write can change a view of.
const FEEDS_VIEWS = new Set([
  "transactions",
  "subscription_billing_overrides",
  "splitwise_expenses",
  "portfolio_holdings",
  "portfolio_snapshots",
  "crypto_holdings",
  "crypto_snapshots",
]);

// What add-holding finds in the demo: a few well-known names, priced at fixed demo prices.
interface DemoSecurity {
  id: string;
  symbol: string;
  name: string;
  detail: string;
  price: number;
  currency: string;
  type: string;
}
const DEMO_SECURITIES: Record<"stock" | "crypto", Array<DemoSecurity>> = {
  stock: [
    {
      id: "VWCE.DE",
      symbol: "VWCE.DE",
      name: "Vanguard FTSE All-World UCITS ETF",
      detail: "ETF · XETRA",
      price: 128,
      currency: "EUR",
      type: "ETF",
    },
    {
      id: "IWDA.AS",
      symbol: "IWDA.AS",
      name: "iShares Core MSCI World UCITS ETF",
      detail: "ETF · Amsterdam",
      price: 97,
      currency: "EUR",
      type: "ETF",
    },
    {
      id: "AAPL",
      symbol: "AAPL",
      name: "Apple Inc.",
      detail: "Stock · NASDAQ",
      price: 190,
      currency: "USD",
      type: "Stock",
    },
  ],
  crypto: [
    {
      id: "bitcoin",
      symbol: "BTC",
      name: "Bitcoin",
      detail: "Rank #1",
      price: 65000,
      currency: "USD",
      type: "Crypto",
    },
    {
      id: "ethereum",
      symbol: "ETH",
      name: "Ethereum",
      detail: "Rank #2",
      price: 3200,
      currency: "USD",
      type: "Crypto",
    },
    {
      id: "solana",
      symbol: "SOL",
      name: "Solana",
      detail: "Rank #5",
      price: 150,
      currency: "USD",
      type: "Crypto",
    },
  ],
};
const DEMO_USD_TO_EUR = 0.92;

// Same answer shape as a non-2xx from the real function: the panel reads error.context.
const functionError = (status: number, message: string) => ({
  data: null,
  error: { message, context: new Response(JSON.stringify({ error: message }), { status }) },
});

const compare = (a: unknown, b: unknown) => {
  const [x, y] = [a, b] as Array<number | string>;
  return x! < y! ? -1 : x! > y! ? 1 : 0;
};

function makeFilter(op: string, col: string, v: unknown): Filter {
  switch (op) {
    case "eq":
      return (r) => r[col] === v;
    case "neq":
      return (r) => r[col] != null && r[col] !== v;
    case "gt":
      return (r) => r[col] != null && compare(r[col], v) > 0;
    case "gte":
      return (r) => r[col] != null && compare(r[col], v) >= 0;
    case "lt":
      return (r) => r[col] != null && compare(r[col], v) < 0;
    case "lte":
      return (r) => r[col] != null && compare(r[col], v) <= 0;
    case "in":
      return (r) => (v as Array<unknown>).includes(r[col]);
    case "is":
      return (r) => (v === null ? r[col] == null : r[col] === v);
    case "ilike": {
      // `*` or `%` any run, `_` any one character, case-insensitive (as PostgREST's ilike).
      const body = String(v)
        .split("")
        .map((c) =>
          c === "*" || c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      const re = new RegExp(`^${body}$`, "is");
      return (r) => r[col] != null && re.test(String(r[col]));
    }
    default:
      throw new Error(`Demo client: unsupported filter "${op}"`);
  }
}

// What the AI would find in a statement PDF: in the demo, three made-up rows from the last days.
function demoStatementRows(now: Date) {
  const day = (back: number) =>
    formatISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
  return [
    { date: day(1), description: "Trattoria Demo", amount: 38.4, direction: "DBIT" },
    { date: day(2), description: "Farmacia Esempio", amount: 12.9, direction: "DBIT" },
    { date: day(3), description: "Rimborso spese", amount: 120, direction: "CRDT" },
  ];
}

// Mirrors payer_name_of and payer_key in the database: the bank's payer, compared without case,
// accents, spacing or punctuation.
const payerNameOf = (t: Row): string | null =>
  String(t["debtor_name"] ?? "").trim() || String(t["creditor_name"] ?? "").trim() || null;
const FOLD: Record<string, string> = {
  ł: "l",
  ø: "o",
  đ: "d",
  ħ: "h",
  ı: "i",
  ß: "ss",
  æ: "ae",
  œ: "oe",
};
export const payerKey = (name: string | null): string | null =>
  (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[łøđħıßæœ]/gu, (ch) => FOLD[ch] ?? ch)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    // Characters, not UTF-16 units, like left() in the database.
    .match(/^[\s\S]{0,200}/u)?.[0]
    .trim() || null;
// Mirrors payback_eligible: plain incoming money only.
const paybackEligible = (t: Row): boolean =>
  t["credit_debit_indicator"] === "CRDT" &&
  !t["deleted_at"] &&
  Number(t["amount"]) > 0 &&
  String(t["flow_type"] ?? "income") === "income" &&
  t["import_batch_id"] == null &&
  t["personal_amount"] == null &&
  t["refund_of"] == null &&
  t["own_counterparty"] !== true;
// owed_by as the page reads it: comma-separated, blanks dropped.
const owedNames = (t: Row): Array<string> =>
  String(t["owed_by"] ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);

class Store {
  readonly db: Record<string, Array<Row>>;
  private nextId = 1;
  private readonly shapes: Map<string, Row>;
  constructor(private readonly now: Date) {
    this.db = generateDemoData(now) as unknown as Record<string, Array<Row>>;
    // Read each table's shape once: the first row is gone once a table is emptied.
    this.shapes = new Map(Object.entries(this.db).map(([t, rows]) => [t, rows[0] ?? {}]));
  }
  private readonly aliases = new Map<string, string>();
  /** Mirror of the database function rename_merchant: returns how many rows changed. */
  renameMerchant(ref: string, account: unknown, name: string | null, onlyThis = false): number {
    const txs = this.db["transactions"]!;
    const isTarget = (r: Row) =>
      r["entry_reference"] === ref && (r["account_uid"] ?? null) === (account ?? null);
    const target = txs.find(isTarget);
    const clean = name?.trim() || null;
    const source = target?.["creditor_name"] as string | null | undefined;
    const rawKey = target?.["merchant_key"] as string | null | undefined;
    // Aggregators (PayPal, ...) say nothing about the real merchant: they group by name and price.
    const aggregator = !!rawKey && ["paypal", "apple", "google"].includes(rawKey);
    const key = rawKey && !aggregator ? rawKey : null;
    const price = aggregator ? Math.abs(Number(target?.["amount"])) : null;
    const nearPrice = (r: Row) =>
      price === null || Math.abs(Math.abs(Number(r["amount"])) - price) <= price * 0.1;
    let changed: Array<Row>;
    if (!source || onlyThis) {
      changed = txs.filter(isTarget);
    } else {
      const aliasKey = price === null ? source : `${source}|${price.toFixed(2)}`;
      const old = this.aliases.get(aliasKey) ?? this.aliases.get(source);
      if (clean) this.aliases.set(aliasKey, clean);
      else this.aliases.delete(aliasKey);
      changed = txs.filter(
        (r) =>
          isTarget(r) ||
          (key !== null && r["merchant_key"] === key && r["custom_name"] == null) ||
          (r["creditor_name"] === source &&
            nearPrice(r) &&
            (r["custom_name"] == null || r["custom_name"] === old)),
      );
    }
    for (const r of changed) r["custom_name"] = clean;
    this.refresh();
    return changed.length;
  }
  /** Mirror of the database function move_category: what was filed under `from` moves to `to`
   * (created with `from`'s look when new), then `from` goes (own: deleted, built-in: hidden). */
  moveCategory(fromArg: unknown, toArg: unknown): Result {
    const from = String(fromArg ?? "").trim();
    const to = String(toArg ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (!from || !to) return { data: null, error: { message: "Pick the category to move to" } };
    if (from === to) return { data: null, error: { message: "Pick a different category" } };
    if (from === "Transfer" || from === "Income")
      return { data: null, error: { message: "Transfer and Income can't be removed" } };
    const own = this.db["user_categories"]!;
    const src = own.find((r) => r["name"] === from);
    const builtIn = (CATEGORIES as ReadonlyArray<string>).includes(from);
    const known = [...CATEGORIES, ...own.map((r) => r["name"] as string)];
    const target = known.find((c) => c !== from && c.toLowerCase() === to.toLowerCase()) ?? to;
    if (!known.includes(target))
      own.push({
        user_id: DEMO_USER_ID,
        name: target,
        hidden: false,
        icon: src?.["icon"] ?? (builtIn ? from.toLowerCase().replace(/ /g, "-") : null),
        color: src?.["color"] ?? null,
        created_at: this.now.toISOString(),
      });
    let moved = 0;
    for (const t of this.db["transactions"]!)
      if (t["category"] === from) {
        t["category"] = target;
        moved += 1;
      }
    for (const b of this.db["category_budgets"]!)
      if (b["category"] === from) b["category"] = target;
    if (builtIn) {
      if (src) src["hidden"] = true;
      else own.push({ user_id: DEMO_USER_ID, name: from, hidden: true, icon: null, color: null });
    } else own.splice(own.indexOf(src!), 1);
    this.refresh();
    return { data: moved, error: null };
  }
  /** Mirror of the database function add_manual_transaction: returns the new row's key. */
  addManualTransaction(args: Record<string, unknown>): {
    data: Array<{ account_uid: string; entry_reference: string }> | null;
    error: { message: string } | null;
  } {
    const amount = Number(args["p_amount"]);
    const description = String(args["p_description"] ?? "").trim();
    const direction = args["p_direction"];
    if (!(amount > 0)) return { data: null, error: { message: "amount must be above zero" } };
    if (!description) return { data: null, error: { message: "description is required" } };
    if (direction !== "DBIT" && direction !== "CRDT")
      return { data: null, error: { message: "direction must be DBIT or CRDT" } };
    const source = String(args["p_source"] ?? "").trim() || "Manual";
    const currency =
      String(args["p_currency"] ?? "")
        .trim()
        .toUpperCase() || "EUR";
    const category = (args["p_category"] as string | null | undefined) ?? null;
    const accounts = this.db["accounts"]!;
    let account = accounts.find(
      (a) => a["manual"] && a["label"] === source && a["currency"] === currency,
    );
    if (!account) {
      account = this.withDefaults("accounts", {
        uid: `demo-manual-${this.nextId++}`,
        currency,
        label: source,
        bank_name: source,
        manual: true,
        consent_valid_until: null,
        iban: null,
      });
      accounts.push(account);
    }
    const entry_reference = `manual-${this.nextId++}`;
    const date = String(args["p_booking_date"]);
    this.db["transactions"]!.push(
      this.withDefaults("transactions", {
        entry_reference,
        account_uid: account["uid"],
        amount,
        currency,
        credit_debit_indicator: direction,
        creditor_name: description,
        custom_name: null,
        booking_date: date,
        value_date: date,
        category,
        category_source: category ? "manual" : null,
        flow_type: category === "Transfer" ? "transfer" : direction === "DBIT" ? "spend" : "income",
        flow_source: "user",
        transaction_type: null,
        worth_it: null,
        personal_amount: null,
        owed_by: null,
        refund_of: null,
        deleted_at: null,
        note: null,
        tags: [],
      }),
    );
    this.refresh();
    return { data: [{ account_uid: account["uid"] as string, entry_reference }], error: null };
  }
  /** Moves the day's net worth from one account balance to another: debts count in liabilities
   * (subtracted from the total), everything else in bank, like v_net_worth_daily. */
  private moveNetWorth(date: unknown, before: [number, boolean], after: [number, boolean]): void {
    const day = this.db["v_net_worth_daily"]!.find((r) => r["snapshot_date"] === date);
    if (!day) return;
    const part = ([eur, debt]: [number, boolean]) => (debt ? [0, Math.abs(eur)] : [eur, 0]);
    const [bank0, owed0] = part(before);
    const [bank1, owed1] = part(after);
    day["bank_total_eur"] = Number(day["bank_total_eur"]) + bank1! - bank0!;
    day["liabilities_eur"] = Number(day["liabilities_eur"] ?? 0) + owed1! - owed0!;
    day["total_eur"] = Number(day["total_eur"]) + bank1! - bank0! - (owed1! - owed0!);
  }
  private latestDay(): string {
    return this.db["v_net_worth_daily"]!.reduce(
      (a, r) => (String(r["snapshot_date"]) > a ? String(r["snapshot_date"]) : a),
      "",
    );
  }
  /** Mirror of the database function set_account_type: past net worth follows the new type. */
  setAccountType(uid: unknown, type: unknown): Result {
    if (type !== null && !ACCOUNT_TYPES.some(([t]) => t === type))
      return { data: null, error: { message: "unknown account type" } };
    const account = this.db["accounts"]!.find((a) => a["uid"] === uid);
    if (!account) return { data: null, error: { message: "account not found" } };
    const [was, now] = [isDebt(account["account_type"] as string | null), isDebt(type as string)];
    account["account_type"] = type;
    for (const r of this.db["v_bank_accounts_latest"]!)
      if (r["uid"] === uid) r["account_type"] = type;
    if (was !== now)
      for (const s of this.db["net_worth_snapshots"]!.filter((s) => s["account_uid"] === uid)) {
        const eur = Number(s["eur_equivalent"] ?? 0);
        this.moveNetWorth(s["snapshot_date"], [eur, was], [eur, now]);
      }
    return { data: null, error: null };
  }
  /** Mirror of the database function add_manual_debt: a manual loan with today's balance. */
  addManualDebt(args: Record<string, unknown>): Result {
    const name = String(args["p_name"] ?? "").trim();
    const amount = Number(args["p_amount"]);
    if (!name) return { data: null, error: { message: "name is required" } };
    if (args["p_amount"] == null || !Number.isFinite(amount))
      return { data: null, error: { message: "amount is required" } };
    const currency = String(args["p_currency"] ?? "EUR").toUpperCase();
    const rate = this.db["fx_rates"]!.filter((r) => r["currency"] === currency)
      .sort((a, b) => String(b["date"]).localeCompare(String(a["date"])))
      .at(0)?.["rate_to_eur"];
    const eur = currency === "EUR" ? amount : amount * Number(rate ?? 1);
    const uid = `demo-debt-${this.nextId++}`;
    const today = this.latestDay();
    this.db["accounts"]!.push(
      this.withDefaults("accounts", {
        uid,
        user_id: DEMO_USER_ID,
        label: name,
        bank_name: name,
        currency,
        manual: true,
        account_type: "loan",
        iban: null,
        consent_valid_until: null,
      }),
    );
    this.db["net_worth_snapshots"]!.push({
      account_uid: uid,
      amount,
      currency,
      eur_equivalent: eur,
      snapshot_date: today,
      user_id: DEMO_USER_ID,
    });
    this.db["v_bank_accounts_latest"]!.push({
      uid,
      user_id: DEMO_USER_ID,
      label: name,
      bank_name: name,
      bank_logo: null,
      bank_country: null,
      iban: null,
      currency,
      consent_valid_until: null,
      snapshot_date: today,
      amount,
      amount_eur: eur,
      account_type: "loan",
      manual: true,
    });
    this.moveNetWorth(today, [0, true], [eur, true]);
    return { data: uid, error: null };
  }
  /** Mirror of the database function set_manual_balance: today's balance of a manual account. */
  /** Mirror of the database function delete_manual_debt: the debt leaves net worth, past days too. */
  deleteManualDebt(uid: unknown): Result {
    const account = this.db["accounts"]!.find((a) => a["uid"] === uid);
    if (!account) return { data: null, error: { message: "account not found" } };
    if (!account["manual"] || !isDebt(account["account_type"] as string | null))
      return { data: null, error: { message: "not a manual debt" } };
    const mine = (r: Row) => r["account_uid"] === uid;
    for (const s of this.db["net_worth_snapshots"]!.filter(mine))
      this.moveNetWorth(s["snapshot_date"], [Number(s["eur_equivalent"] ?? 0), true], [0, true]);
    this.db["net_worth_snapshots"] = this.db["net_worth_snapshots"]!.filter((r) => !mine(r));
    this.db["accounts"] = this.db["accounts"]!.filter((a) => a !== account);
    this.db["v_bank_accounts_latest"] = this.db["v_bank_accounts_latest"]!.filter(
      (r) => r["uid"] !== uid,
    );
    return { data: null, error: null };
  }
  setManualBalance(uid: unknown, value: unknown): Result {
    const account = this.db["accounts"]!.find((a) => a["uid"] === uid);
    if (!account) return { data: null, error: { message: "account not found" } };
    if (!account["manual"]) return { data: null, error: { message: "not a manual account" } };
    const amount = Number(value);
    const row = this.db["v_bank_accounts_latest"]!.find((r) => r["uid"] === uid);
    if (!row || !Number.isFinite(amount)) return { data: null, error: null };
    const oldEur = Number(row["amount_eur"] ?? 0);
    const eur = row["amount"] ? (oldEur * amount) / Number(row["amount"]) : amount;
    const debt = isDebt(account["account_type"] as string | null);
    const today = this.latestDay();
    // Only today's balance changes; earlier days keep theirs.
    const snap = this.db["net_worth_snapshots"]!.find(
      (s) => s["account_uid"] === uid && s["snapshot_date"] === today,
    );
    if (snap) Object.assign(snap, { amount, eur_equivalent: eur });
    else
      this.db["net_worth_snapshots"]!.push({
        account_uid: uid,
        amount,
        currency: account["currency"],
        eur_equivalent: eur,
        snapshot_date: today,
        user_id: DEMO_USER_ID,
      });
    this.moveNetWorth(today, [oldEur, debt], [eur, debt]);
    Object.assign(row, { amount, amount_eur: eur, snapshot_date: today });
    return { data: null, error: null };
  }
  /** Mirror of the database function resolve_transfer_pair: keep makes both sides a transfer the
   * user decided; not keeping puts each paired side back by its direction (a bank-coded side,
   * EXCHANGE or TOPUP, stays a transfer). */
  resolveTransferPair(id: unknown, keep: boolean): Result {
    const pair = this.db["transfer_pairs"]!.find((p) => p["id"] === id);
    if (!pair || pair["status"] !== "suggested")
      return { data: null, error: { message: "pair not found" } };
    const sides = [
      [pair["out_account_uid"], pair["out_ref"]],
      [pair["in_account_uid"], pair["in_ref"]],
    ];
    const rows = this.db["transactions"]!.filter((r) =>
      sides.some(([a, ref]) => r["account_uid"] === a && r["entry_reference"] === ref),
    );
    // Like the database: Keep is refused once a side was changed since the pairing.
    if (
      keep &&
      (rows.length < 2 || rows.some((r) => !["pair", "bank"].includes(String(r["flow_source"]))))
    )
      return { data: null, error: { message: "pair is stale" } };
    pair["status"] = keep ? "confirmed" : "rejected";
    for (const r of rows) {
      if (!keep && r["flow_source"] !== "pair") continue;
      r["flow_source"] = "user";
      if (!keep) r["flow_type"] = r["credit_debit_indicator"] === "DBIT" ? "spend" : "income";
    }
    this.refresh();
    return { data: null, error: null };
  }
  /** Mirror of the database function set_holding_quantity: the new quantity, and today's value
   * from the latest price, taken into net worth at once. Returns how many holdings changed. */
  setHoldingQuantity(kind: unknown, key: unknown, quantity: unknown, source: unknown): number {
    const db = this.db;
    const stock = kind === "stock";
    const qty = Number(quantity);
    const isRow = (r: Row) =>
      stock ? r["isin"] === key : r["asset_symbol"] === key && r["source"] === source;
    const holding = db[stock ? "portfolio_holdings" : "crypto_holdings"]!.find(isRow);
    if (!holding || !(qty >= 0)) return 0;
    const qtyField = stock ? "shares" : "amount";
    const oldQty = Number(holding[qtyField]);
    holding[qtyField] = qty;
    const snaps = db[stock ? "portfolio_snapshots" : "crypto_snapshots"]!.filter(isRow);
    const last = snaps.reduce<Row | undefined>(
      (a, r) => (!a || String(r["snapshot_date"]) > String(a["snapshot_date"]) ? r : a),
      undefined,
    );
    if (last && oldQty > 0) {
      const oldValue = Number(last["value_eur"] ?? 0);
      const newValue = (oldValue * qty) / oldQty;
      last["value_eur"] = newValue;
      if (stock) last["value_native"] = (Number(last["value_native"] ?? 0) * qty) / oldQty;
      else {
        last["amount"] = qty;
        last["value_usd"] = (Number(last["value_usd"] ?? 0) * qty) / oldQty;
      }
      const daily = db["v_net_worth_daily"] ?? [];
      const latest = daily.reduce<Row | undefined>(
        (a, r) => (!a || String(r["snapshot_date"]) > String(a["snapshot_date"]) ? r : a),
        undefined,
      );
      if (latest) {
        const field = stock ? "portfolio_total_eur" : "crypto_total_eur";
        latest[field] = Number(latest[field]) + newValue - oldValue;
        latest["total_eur"] = Number(latest["total_eur"]) + newValue - oldValue;
      }
    }
    this.refresh();
    return 1;
  }
  /** Mirror of the database function delete_holding: returns how many holdings were deleted. */
  deleteHolding(kind: unknown, key: unknown, source: unknown): number {
    const db = this.db;
    const stock = kind === "stock";
    const isRow = (r: Row) =>
      stock ? r["isin"] === key : r["asset_symbol"] === key && r["source"] === source;
    const snapTable = stock ? "portfolio_snapshots" : "crypto_snapshots";
    const holdTable = stock ? "portfolio_holdings" : "crypto_holdings";
    // The demo's net worth is generated once, so take the deleted value out of it by hand.
    const removed = new Map<string, number>();
    for (const s of db[snapTable]!.filter(isRow)) {
      const d = s["snapshot_date"] as string;
      removed.set(d, (removed.get(d) ?? 0) + ((s["value_eur"] as number | null) ?? 0));
    }
    for (const r of db["v_net_worth_daily"] ?? []) {
      const minus = removed.get(r["snapshot_date"] as string) ?? 0;
      const field = stock ? "portfolio_total_eur" : "crypto_total_eur";
      r[field] = (r[field] as number) - minus;
      r["total_eur"] = (r["total_eur"] as number) - minus;
    }
    db[snapTable] = db[snapTable]!.filter((r) => !isRow(r));
    const before = db[holdTable]!.length;
    db[holdTable] = db[holdTable]!.filter((r) => !isRow(r));
    const count = before - db[holdTable]!.length;
    const coinLeft = !stock && db[holdTable]!.some((r) => r["asset_symbol"] === key);
    if (!coinLeft) {
      db["holding_trades"] = (db["holding_trades"] ?? []).filter(
        (t) => !(t["kind"] === (stock ? "stock" : "crypto") && t["key"] === key),
      );
      db["investment_events"] = (db["investment_events"] ?? []).filter(
        (e) => !(e["asset_kind"] === (stock ? "stock" : "crypto") && e["key"] === key),
      );
    }
    this.refresh();
    return count;
  }
  // Each stream's status as generated, so one marked gone comes back when it is charged again.
  private readonly detected = new Map<unknown, unknown>();
  /** Like refresh-recurring's detector: it skips charges you set One-time yourself, so a stream
   * left with none of its charges is gone, and one left with some is dated and rated from those. */
  refreshStreams(): Result {
    const txs = this.db["transactions"]!;
    const streams = this.db["recurring_streams"]!;
    for (const s of streams) {
      if (!this.detected.has(s["id"])) this.detected.set(s["id"], s["detected_status"]);
      const charges = txs.filter(
        (t) => t["merchant_key"] === s["merchant_key"] && t["account_uid"] === s["account_uid"],
      );
      const counted = charges.filter(
        (t) => !(t["transaction_type"] === "One-time" && t["transaction_type_source"] === "manual"),
      );
      const allMine = charges.length > 0 && counted.length === 0;
      // One charge left has no rhythm, so the detector only suggests it (your own choice is kept).
      const days = new Set(counted.map((t) => t["booking_date"])).size;
      s["detected_status"] = allMine
        ? "gone"
        : days === 1
          ? "suggested"
          : this.detected.get(s["id"]);
      if (counted.length === 0) continue;
      // As the demo seeds it: the newest charge left, plus one period of the stream's cadence.
      const last = counted.map((t) => t["booking_date"] as string).sort()[counted.length - 1]!;
      s["last_charged"] = last;
      s["next_expected"] = addDays(last, PERIOD_DAYS[s["cadence"] as string] ?? 30);
    }
    const found = streams.filter((s) => s["detected_status"] !== "gone").length;
    return { data: { streams: found }, error: null };
  }
  /** Mirror of the database function stream_action: an {error} where the SQL raises. */
  streamAction(id: unknown, action: unknown, args: Row = {}): Result {
    const row = this.db["recurring_streams"]!.find((r) => r["id"] === id);
    if (!row) return { data: null, error: { message: "stream not found" } };
    const bad = (message: string): Result => ({ data: null, error: { message } });
    if (action === "confirm") row["user_status"] = "confirmed";
    else if (action === "dismiss") row["user_status"] = "dismissed";
    else if (action === "undismiss")
      row["user_status"] = row["detected_status"] == null ? "confirmed" : null;
    else if (action === "set_cadence") {
      const cadence = args["cadence"] as string | undefined;
      const unit = args["custom_unit"];
      const value = args["custom_value"];
      if (cadence) {
        if (!["weekly", "monthly", "quarterly", "yearly"].includes(cadence))
          return bad("invalid cadence");
        Object.assign(row, {
          user_cadence: cadence,
          custom_interval_value: null,
          custom_interval_unit: null,
        });
      } else {
        if (
          !Number.isInteger(value) ||
          (value as number) <= 0 ||
          !["days", "weeks", "months", "years"].includes(unit as string)
        )
          return bad("invalid custom interval");
        Object.assign(row, {
          user_cadence: "custom",
          custom_interval_value: value,
          custom_interval_unit: unit,
        });
      }
      row["user_status"] = "confirmed";
    } else return bad("unknown action");
    return { data: null, error: null };
  }
  /** Mirror of payback_candidates: recent incoming payments nobody has checked, with the payer. */
  paybackCandidates(days: unknown) {
    const span = Math.min(Math.max(Number(days) || 60, 1), 366);
    const since = new Date(this.now.getTime() - span * 864e5).toISOString().slice(0, 10);
    const links = this.db["payer_links"] ?? [];
    const data = (this.db["transactions"] ?? [])
      .filter(
        (t) =>
          paybackEligible(t) && t["payback_contact"] == null && String(t["booking_date"]) >= since,
      )
      .sort((a, b) => compare(b["booking_date"], a["booking_date"]))
      .slice(0, 200)
      .map((t) => {
        const payer = payerNameOf(t);
        const key = payerKey(payer);
        return {
          account_uid: t["account_uid"],
          entry_reference: t["entry_reference"],
          booking_date: t["booking_date"],
          amount: t["amount"],
          currency: t["currency"],
          amount_eur: t["currency"] === "EUR" ? Number(t["amount"]) : null,
          payer,
          linked_contact: links.find((l) => l["payer_key"] === key)?.["contact"] ?? null,
        };
      });
    return { data, error: null };
  }
  /** Mirror of record_payback: oldest open bills of that person first, whole bills only. */
  recordPayback(args: Record<string, unknown>) {
    if (args["p_contact"] == null)
      return { data: null, error: { message: "Contact required", code: "P0001" } };
    const txs = this.db["transactions"] ?? [];
    const credit = txs.find(
      (t) =>
        t["account_uid"] === args["p_account"] &&
        t["entry_reference"] === args["p_ref"] &&
        t["credit_debit_indicator"] === "CRDT" &&
        !t["deleted_at"],
    );
    if (!credit) return { data: null, error: { message: "Payment not found", code: "P0001" } };
    if (credit["payback_contact"] != null)
      return { data: null, error: { message: "Payment already checked", code: "P0001" } };
    const contact = String(args["p_contact"]).trim();
    if ([...contact].length > 100)
      return { data: null, error: { message: "Contact name too long", code: "P0001" } };
    if (!paybackEligible(credit))
      return { data: null, error: { message: "Payment not found", code: "P0001" } };
    if (contact === "") {
      credit["payback_contact"] = "";
      const key = payerKey(payerNameOf(credit));
      this.db["payer_links"] = (this.db["payer_links"] ?? []).filter((l) => l["payer_key"] !== key);
      return { data: { settled: [], settled_eur: 0, left_eur: null, linked: false }, error: null };
    }
    credit["payback_contact"] = contact;
    credit["flow_type"] = "transfer";
    credit["flow_source"] = "user";
    let left = credit["currency"] === "EUR" ? Number(credit["amount"]) : null;
    let settledEur = 0;
    const settled: Array<string> = [];
    // Signed like the view: what they owe on a bill, minus what a split refund owes them.
    const owedOf = (t: Row) =>
      Math.round(
        (Number(t["amount"]) - Number(t["personal_amount"])) *
          (t["credit_debit_indicator"] === "DBIT" ? 100 : -100),
      ) / 100;
    const rows = txs
      .filter(
        (t) =>
          !t["deleted_at"] &&
          !t["owed_settled"] &&
          t["personal_amount"] != null &&
          Number(t["personal_amount"]) >= 0 &&
          t["import_batch_id"] == null &&
          !["refunded", "transfer"].includes(String(t["flow_type"] ?? "")) &&
          owedNames(t).join(",") === contact.toLowerCase() &&
          owedOf(t) !== 0,
      )
      .sort(
        (a, b) =>
          compare(a["booking_date"], b["booking_date"]) ||
          compare(a["entry_reference"], b["entry_reference"]),
      );
    const refunds = rows.filter((t) => owedOf(t) < 0);
    const credits = refunds.reduce((sum, t) => sum + owedOf(t), 0);
    if (left !== null) left -= credits;
    const settle = (b: Row) =>
      Object.assign(b, {
        owed_settled: true,
        settled_at: this.now.toISOString(),
        settled_by_account: credit["account_uid"],
        settled_by_ref: credit["entry_reference"],
      });
    for (const b of rows.filter((t) => owedOf(t) > 0)) {
      const owed = owedOf(b);
      if (left === null || owed > left + 0.005) break;
      settle(b);
      left -= owed;
      settledEur += owed;
      settled.push(String(b["entry_reference"]));
    }
    if (credits < 0) {
      if (settledEur + credits >= -0.005) {
        // The settled bills use the refunds in full: close them too.
        refunds.forEach(settle);
        settledEur += credits;
      } else {
        // Only part of a refund would be used, and it can't settle in part: settle nothing.
        for (const b of txs)
          if (
            b["settled_by_account"] === credit["account_uid"] &&
            b["settled_by_ref"] === credit["entry_reference"]
          )
            Object.assign(b, {
              owed_settled: false,
              settled_at: null,
              settled_by_account: null,
              settled_by_ref: null,
            });
        if (left !== null) left += credits + settledEur;
        settledEur = 0;
        settled.length = 0;
      }
    }
    let linked = false;
    const key = payerKey(payerNameOf(credit));
    if (args["p_remember"] !== false && key) {
      const links = (this.db["payer_links"] ??= []);
      const hit = links.find((l) => l["payer_key"] === key);
      linked = !hit || hit["contact"] !== contact;
      if (!hit)
        links.push({
          user_id: DEMO_USER_ID,
          payer_key: key,
          contact,
          created_at: this.now.toISOString(),
        });
      else hit["contact"] = contact;
    }
    this.refresh();
    return {
      data: {
        settled,
        settled_eur: Math.round(settledEur * 100) / 100,
        left_eur: left === null ? null : Math.max(Math.round(left * 100) / 100, 0),
        linked,
      },
      error: null,
    };
  }
  /** Mirror of undo_payback. */
  undoPayback(args: Record<string, unknown>) {
    const txs = this.db["transactions"] ?? [];
    const credit = txs.find(
      (t) =>
        t["account_uid"] === args["p_account"] &&
        t["entry_reference"] === args["p_ref"] &&
        t["credit_debit_indicator"] === "CRDT",
    );
    if (!credit || credit["payback_contact"] == null)
      return { data: null, error: { message: "Payment not found", code: "P0001" } };
    let reopened = 0;
    for (const b of txs)
      if (
        b["settled_by_account"] === credit["account_uid"] &&
        b["settled_by_ref"] === credit["entry_reference"]
      ) {
        Object.assign(b, {
          owed_settled: false,
          settled_at: null,
          settled_by_account: null,
          settled_by_ref: null,
        });
        reopened++;
      }
    if (credit["payback_contact"] !== "") {
      credit["flow_type"] = null;
      credit["flow_source"] = null;
    }
    credit["payback_contact"] = null;
    if (args["p_forget"] === true) {
      const key = payerKey(payerNameOf(credit));
      this.db["payer_links"] = (this.db["payer_links"] ?? []).filter((l) => l["payer_key"] !== key);
    }
    this.refresh();
    return { data: { reopened }, error: null };
  }
  refresh(): void {
    Object.assign(this.db, deriveViews(this.db as unknown as DemoDb));
  }
  withDefaults(table: string, row: Row): Row {
    const sample = this.shapes.get(table);
    const out = { ...row };
    if (sample && "id" in sample && out["id"] == null) out["id"] = `demo-new-${this.nextId++}`;
    if (sample && "created_at" in sample && out["created_at"] == null)
      out["created_at"] = new Date().toISOString();
    return out;
  }
}

class Query implements PromiseLike<Result> {
  private filters: Array<Filter> = [];
  private sorts: Array<{ col: string; asc: boolean }> = [];
  private max: number | undefined;
  private skip = 0;
  private mode: Mode = "select";
  private payload: Array<Row> = [];
  private patch: Row = {};
  private conflict: Array<string> = [];
  private head = false;
  private wantCount = false;
  private ignoreDuplicates = false;
  private one: "one" | "maybe" | null = null;

  constructor(
    private readonly store: Store,
    private readonly table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    this.head = !!opts?.head;
    this.wantCount = !!opts?.count;
    return this;
  }
  insert(rows: Row | Array<Row>) {
    this.mode = "insert";
    this.payload = [rows].flat();
    return this;
  }
  upsert(rows: Row | Array<Row>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.mode = "upsert";
    this.payload = [rows].flat();
    this.conflict = opts?.onConflict?.split(",") ?? [];
    this.ignoreDuplicates = !!opts?.ignoreDuplicates;
    return this;
  }
  update(patch: Row) {
    this.mode = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }

  eq(c: string, v: unknown) {
    return this.where("eq", c, v);
  }
  neq(c: string, v: unknown) {
    return this.where("neq", c, v);
  }
  gt(c: string, v: unknown) {
    return this.where("gt", c, v);
  }
  gte(c: string, v: unknown) {
    return this.where("gte", c, v);
  }
  lt(c: string, v: unknown) {
    return this.where("lt", c, v);
  }
  lte(c: string, v: unknown) {
    return this.where("lte", c, v);
  }
  in(c: string, v: Array<unknown>) {
    return this.where("in", c, v);
  }
  is(c: string, v: unknown) {
    return this.where("is", c, v);
  }
  ilike(c: string, v: string) {
    return this.where("ilike", c, v);
  }
  not(c: string, op: string, v: unknown) {
    const f = makeFilter(op, c, v);
    this.filters.push((r) => !f(r));
    return this;
  }
  // PostgREST's `or`, for the plain "col.op.value,col.op.value" lists the dashboard sends. Demo
  // only: it splits on `,` and knows no quoting, so a value with a comma or quotes is misread.
  or(expr: string) {
    const parts = expr.split(",").map((p) => {
      const [col = "", op = "", ...rest] = p.split(".");
      const raw = rest.join(".");
      return makeFilter(op, col, op === "is" && raw === "null" ? null : raw);
    });
    this.filters.push((r) => parts.some((f) => f(r)));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.sorts.push({ col, asc: opts?.ascending ?? true });
    return this;
  }
  range(from: number, to: number) {
    this.skip = from;
    this.max = to + 1;
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.one = "maybe";
    return this;
  }
  single() {
    this.one = "one";
    return this;
  }

  private where(op: string, c: string, v: unknown) {
    this.filters.push(makeFilter(op, c, v));
    return this;
  }

  private execute(): Result {
    const rows = this.store.db[this.table];
    if (!rows)
      return { data: null, error: { message: `Unknown table "${this.table}" in the demo.` } };
    const matches = rows.filter((r) => this.filters.every((f) => f(r)));
    let affected = matches;
    if (this.mode === "insert") affected = this.payload.map((p) => this.insertRow(rows, p));
    if (this.mode === "upsert")
      affected = this.payload.flatMap((p): Array<Row> => {
        const row = this.upsertRow(rows, p);
        return row ? [row] : [];
      });
    if (this.mode === "update") matches.forEach((r) => Object.assign(r, this.patch));
    if (this.mode === "delete")
      this.store.db[this.table] = rows.filter((r) => !matches.includes(r));
    if (this.mode !== "select" && FEEDS_VIEWS.has(this.table)) this.store.refresh();

    const count = this.wantCount ? affected.length : null;
    if (this.head) return { data: null, error: null, count };
    if (this.mode === "delete") return { data: null, error: null, count };
    return this.shape(affected, count);
  }

  private insertRow(rows: Array<Row>, p: Row): Row {
    const row = this.store.withDefaults(this.table, p);
    rows.push(row);
    return row;
  }

  // Like Postgres: a null in the key never matches (nulls are distinct), and ignoreDuplicates
  // leaves the saved row alone and doesn't return it.
  private upsertRow(rows: Array<Row>, p: Row): Row | null {
    const hit = rows.find(
      (r) => this.conflict.length > 0 && this.conflict.every((c) => p[c] != null && r[c] === p[c]),
    );
    if (!hit) return this.insertRow(rows, p);
    return this.ignoreDuplicates ? null : Object.assign(hit, p);
  }

  private shape(rows: Array<Row>, count: number | null): Result {
    const sorted = [...rows];
    for (const { col, asc } of [...this.sorts].reverse()) {
      sorted.sort((a, b) => {
        if (a[col] == null || b[col] == null)
          return (a[col] == null ? 1 : 0) - (b[col] == null ? 1 : 0);
        return asc ? compare(a[col], b[col]) : compare(b[col], a[col]);
      });
    }
    const copies = sorted.slice(this.skip, this.max).map((r) => ({ ...r }));
    if (this.one === null) return { data: copies, error: null, count };
    if (copies.length === 1) return { data: copies[0], error: null, count };
    if (copies.length === 0 && this.one === "maybe") return { data: null, error: null, count };
    return { data: null, error: { message: `Expected one row, got ${copies.length}.` } };
  }

  then<A = Result, B = never>(
    ok?: ((v: Result) => A | PromiseLike<A>) | null,
    fail?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(ok, fail);
  }
}

function demoAddHolding(store: Store, now: Date, body: Record<string, unknown>) {
  const kind = body["kind"] === "crypto" ? "crypto" : "stock";
  const list = DEMO_SECURITIES[kind];
  if (body["action"] === "search") {
    const q = String(body["query"] ?? "").toLowerCase();
    const hits = list.filter((s) => `${s.name} ${s.symbol}`.toLowerCase().includes(q));
    return {
      data: {
        results: (hits.length > 0 ? hits : list).map(({ id, symbol, name, detail }) => ({
          id,
          symbol,
          name,
          detail,
        })),
      },
      error: null,
    };
  }
  const sec = list.find((s) => s.id === body["id"]);
  const quantity = Number(body["quantity"]);
  if (!sec || !(quantity > 0)) return functionError(400, "Invalid request");
  // The local day, as the generated net worth uses: the UTC one is yesterday after local midnight.
  const today = formatISODate(now);
  const user_id = DEMO_USER_ID;
  const db = store.db;
  if (kind === "stock") {
    const isin = (body["isin"] as string | undefined) ?? sec.id;
    if (db["portfolio_holdings"]!.some((h) => h["isin"] === isin)) {
      return functionError(409, "Already in your holdings: change its quantity instead");
    }
    const native = sec.price * quantity;
    db["portfolio_holdings"]!.push({
      asset_type: sec.type,
      broker_label: (body["broker"] as string | undefined) || "Other",
      created_at: now.toISOString(),
      isin,
      name: sec.name,
      shares: quantity,
      user_id,
      yahoo_symbol: sec.id,
    });
    db["portfolio_snapshots"]!.push({
      created_at: now.toISOString(),
      currency: sec.currency,
      isin,
      price: sec.price,
      snapshot_date: today,
      user_id,
      value_eur: sec.currency === "USD" ? native * DEMO_USD_TO_EUR : native,
      value_native: native,
    });
  } else {
    if (
      db["crypto_holdings"]!.some(
        (h) => h["asset_symbol"] === sec.symbol && h["source"] === "Manual",
      )
    ) {
      return functionError(409, "Already in your holdings: change its quantity instead");
    }
    const usd = sec.price * quantity;
    db["crypto_holdings"]!.push({
      amount: quantity,
      asset_symbol: sec.symbol,
      coingecko_id: sec.id,
      created_at: now.toISOString(),
      name: sec.name,
      source: "Manual",
      user_id,
    });
    db["crypto_snapshots"]!.push({
      amount: quantity,
      asset_symbol: sec.symbol,
      created_at: now.toISOString(),
      price_usd: sec.price,
      snapshot_date: today,
      source: "Manual",
      user_id,
      value_eur: usd * DEMO_USD_TO_EUR,
      value_usd: usd,
    });
  }
  // The demo's net worth is generated once, so add the new holding's value to it by hand.
  const added = db[kind === "stock" ? "portfolio_snapshots" : "crypto_snapshots"]!.at(-1)!;
  const latest = (db["v_net_worth_daily"] ?? []).reduce<Row | undefined>(
    (a, r) => (!a || String(r["snapshot_date"]) > String(a["snapshot_date"]) ? r : a),
    undefined,
  );
  if (latest) {
    const field = kind === "stock" ? "portfolio_total_eur" : "crypto_total_eur";
    const value = Number(added["value_eur"]);
    latest[field] = Number(latest[field]) + value;
    latest["total_eur"] = Number(latest["total_eur"]) + value;
  }
  store.refresh();
  return { data: { added: true, priced: true }, error: null };
}

// The demo looks connected to Splitwise, as a made-up "Alex", last synced two hours ago. Sync,
// disconnect and the review actions stay off (functions and other database calls are refused).
function demoSplitwiseConnection(now: Date) {
  return {
    connected: true,
    status: "ok",
    display_name: "Alex",
    last_synced_at: new Date(now.getTime() - 2 * 3_600_000).toISOString(),
    last_error: null,
    synced_data: true,
  };
}

export function createFakeClient(now: Date = new Date()): SupabaseClient<Database> {
  const store = new Store(now);
  const user = {
    id: DEMO_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "demo@example.com",
    app_metadata: {},
    user_metadata: { welcome_dismissed: true } as Record<string, unknown>,
    created_at: now.toISOString(),
  };
  const session = {
    access_token: "demo",
    refresh_token: "demo",
    expires_in: 3600,
    token_type: "bearer",
    user,
  };
  const listeners = new Set<(event: string, session: unknown) => void>();

  const client = {
    from: (table: string) => new Query(store, table),
    rpc: async (fn: string, args: Record<string, unknown> = {}) =>
      fn === "move_category"
        ? store.moveCategory(args["p_from"], args["p_to"])
        : fn === "payback_candidates"
          ? store.paybackCandidates(args["p_days"])
          : fn === "record_payback"
            ? store.recordPayback(args)
            : fn === "undo_payback"
              ? store.undoPayback(args)
              : fn === "holding_performance"
                ? {
                    data: demoHoldingPerformance(store.db, args["p_from"] as string | undefined),
                    error: null,
                  }
                : fn === "rename_merchant"
                  ? {
                      data: store.renameMerchant(
                        args["p_entry_reference"] as string,
                        args["p_account_uid"],
                        (args["p_name"] as string | null) ?? null,
                        args["p_only_this"] === true,
                      ),
                      error: null,
                    }
                  : fn === "resolve_transfer_pair"
                    ? store.resolveTransferPair(args["p_pair"], args["p_keep"] === true)
                    : fn === "stream_action"
                      ? store.streamAction(
                          args["p_stream"],
                          args["p_action"],
                          args["p_args"] as Row,
                        )
                      : fn === "add_manual_transaction"
                        ? store.addManualTransaction(args)
                        : fn === "set_account_type"
                          ? store.setAccountType(args["p_account"], args["p_type"] ?? null)
                          : fn === "add_manual_debt"
                            ? store.addManualDebt(args)
                            : fn === "set_manual_balance"
                              ? store.setManualBalance(args["p_account"], args["p_amount"])
                              : fn === "delete_manual_debt"
                                ? store.deleteManualDebt(args["p_account"])
                                : fn === "set_holding_quantity"
                                  ? {
                                      data: store.setHoldingQuantity(
                                        args["p_kind"],
                                        args["p_key"],
                                        args["p_quantity"],
                                        args["p_source"],
                                      ),
                                      error: null,
                                    }
                                  : fn === "delete_holding"
                                    ? {
                                        data: store.deleteHolding(
                                          args["p_kind"],
                                          args["p_key"],
                                          args["p_source"],
                                        ),
                                        error: null,
                                      }
                                    : fn === "my_transaction_tags"
                                      ? {
                                          data: demoTagCounts(store.db["transactions"] ?? []),
                                          error: null,
                                        }
                                      : fn === "get_splitwise_connection"
                                        ? { data: [demoSplitwiseConnection(now)], error: null }
                                        : { data: null, error: DISABLED },
    functions: {
      invoke: async (name: string, opts?: { body?: Record<string, unknown> }) =>
        name === "add-holding"
          ? demoAddHolding(store, now, opts?.body ?? {})
          : name === "list-banks"
            ? {
                data: {
                  banks: [
                    { name: "Demo Bank", logo: null },
                    { name: "Sample Bank", logo: null },
                  ],
                },
                error: null,
              }
            : name === "parse-statement"
              ? { data: { rows: demoStatementRows(now) }, error: null }
              : name === "reapply-rules"
                ? { data: { changes: 0, sample: [] }, error: null } // demo rows already follow its rules
                : name === "refresh-recurring"
                  ? store.refreshStreams()
                  : // With a body, callers show "Disabled in the demo.", not their fallback (#148).
                    functionError(403, DISABLED.message),
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user }, error: null }),
      updateUser: async ({ data }: { data?: Record<string, unknown> }) => {
        Object.assign(user.user_metadata, data);
        return { data: { user }, error: null };
      },
      signInWithPassword: async () => ({ data: {}, error: DISABLED }),
      signOut: async () => {
        listeners.forEach((cb) => cb("SIGNED_OUT", null));
        return { error: null };
      },
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        listeners.add(cb);
        return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
      },
    },
  };
  return client as unknown as SupabaseClient<Database>;
}

let shared: SupabaseClient<Database> | null = null;
/** One fake client per demo visit; resetDemoClient() makes the next visit start from scratch. */
export const getDemoClient = () => (shared ??= createFakeClient());
export const resetDemoClient = () => {
  shared = null;
};

onDemoExit(resetDemoClient);

/**
 * Like the my_transaction_tags function: every tag on live rows, most used first. Tags that differ
 * only in case count as one, shown in the spelling used most.
 */
export function demoTagCounts(rows: Array<Row>): Array<{ tag: string; uses: number }> {
  const groups = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r["deleted_at"]) continue;
    for (const t of (r["tags"] as Array<string> | undefined) ?? []) {
      const spellings = groups.get(t.toLowerCase()) ?? new Map<string, number>();
      spellings.set(t, (spellings.get(t) ?? 0) + 1);
      groups.set(t.toLowerCase(), spellings);
    }
  }
  return [...groups.values()]
    .map((spellings) => {
      const [tag] = [...spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
      return { tag, uses: [...spellings.values()].reduce((a, b) => a + b, 0) };
    })
    .sort((a, b) => b.uses - a.uses || a.tag.localeCompare(b.tag));
}
