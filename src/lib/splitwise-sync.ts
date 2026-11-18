import { supabase } from "@/integrations/supabase/client";
import { functionErrorBody } from "@/lib/function-error";
import type { ClassifiedRow } from "@/lib/import/splitwise-classify";
import { matchBank, type BankTx, type RateToEur } from "@/lib/import/splitwise-match";
import { refreshKeys } from "@/lib/import/last-import";
import { numberFormat } from "@/lib/locale";

// The dashboard side of the Splitwise API sync: the connection's status, the two Edge Functions
// (splitwise-connect, sync-splitwise) and the To link list (splitwise_review). The server does
// the reading and writing; this file only asks and reports.

export const CONNECTION_KEY = ["splitwise-connection"];
export const REVIEW_KEY = ["splitwise-review"];

/** What to refetch after a sync, a disconnect or a review action: shares, spending, bank rows. */
export const syncRefreshKeys = (): Array<Array<string>> => [
  ...refreshKeys("splitwise"),
  CONNECTION_KEY,
  REVIEW_KEY,
];

export type ConnectionStatus = "ok" | "needs_reconnect" | "error";

export interface SplitwiseConnection {
  connected: boolean;
  status: ConnectionStatus | null;
  displayName: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Something the sync brought in is still here (after "Disconnect, keep data", say). */
  syncedData: boolean;
}

/** The signed-in user's own connection (never the key), from get_splitwise_connection. */
export async function fetchConnection(): Promise<SplitwiseConnection> {
  const { data, error } = await supabase.rpc("get_splitwise_connection");
  // A backend without the sync (PostgREST: no such function) is simply not connected; any other
  // failure is an error, never "not connected" (that would offer to connect again).
  const noSync =
    error?.code === "PGRST202" || error?.message.startsWith("Could not find the function");
  if (error && !noSync) throw new Error(error.message);
  const row = error ? undefined : data?.[0];
  return {
    connected: row?.connected === true,
    status: (row?.status as ConnectionStatus | null | undefined) ?? null,
    displayName: row?.display_name ?? null,
    lastSyncedAt: row?.last_synced_at ?? null,
    lastError: row?.last_error ?? null,
    syncedData: row?.synced_data === true,
  };
}

/**
 * Where the Splitwise balances on screen come from, for their title, or null when that isn't
 * sure: loading, failed, or disconnected with synced data kept (a later file may replace a group).
 */
export function balancesSource(
  c: SplitwiseConnection | undefined,
  /** No groups on screen: "from your last import" would claim an import that never happened. */
  hasGroups = true,
): string | null {
  if (!c) return null;
  if (c.connected) return c.status === "ok" ? "synced from Splitwise" : "from your last sync";
  return c.syncedData || !hasGroups ? null : "from your last import";
}

/** A failed Edge Function call: the function's own message, its HTTP status and `code`. */
export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
  }
  /** "Synced a moment ago" or Splitwise asking to slow down: nothing is wrong. */
  get rateLimited() {
    return this.status === 429;
  }
}

async function call<T>(name: string, body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (error) {
    const reply = (await functionErrorBody(error)) as { error?: unknown; code?: unknown } | null;
    const context = (error as { context?: unknown }).context;
    const message = typeof reply?.error === "string" && reply.error.trim() ? reply.error : fallback;
    throw new SyncError(
      message,
      context instanceof Response ? context.status : null,
      typeof reply?.code === "string" ? reply.code : null,
    );
  }
  return data as T;
}

/** What a sync brought in (or, for a preview, would). */
export interface SyncCounts {
  new: number;
  adopted: number;
  review: number;
  deleted: number;
}

export const connectSplitwise = (apiKey: string) =>
  call<{ displayName: string }>(
    "splitwise-connect",
    { apiKey: apiKey.trim(), consent: true },
    "Couldn't connect Splitwise. Try again later.",
  );

export const disconnectSplitwise = (deleteData: boolean) =>
  call<{ disconnected: boolean; deleted: number }>(
    "splitwise-connect",
    { disconnect: true, deleteData },
    "Couldn't disconnect Splitwise. Try again later.",
  );

export const previewSync = () =>
  call<SyncCounts>(
    "sync-splitwise",
    { preview: true },
    "Couldn't check Splitwise. Try again later.",
  );

export const syncNow = () =>
  call<SyncCounts>("sync-splitwise", {}, "Couldn't sync with Splitwise. Try again later.");

/** A count as every figure in the app is written: "1.234" in Italian or German. */
export const formatCount = (n: number) => numberFormat().format(n);

const count = (n: number, one: string, many = `${one}s`) =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

/** "2 new expenses, 1 to link", or "Nothing new" when the sync changed nothing. */
export function syncSummary(c: SyncCounts): string {
  const parts = [
    c.new > 0 && count(c.new, "new expense"),
    c.adopted > 0 && `${count(c.adopted, "expense")} already imported`,
    c.review > 0 && `${formatCount(c.review)} to link`,
    c.deleted > 0 && `${formatCount(c.deleted)} removed`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing new";
}

/** "Synced 5 min ago": how long since the last sync, in plain words. */
export function syncedAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "Not synced yet";
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "Not synced yet";
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `Synced ${count(days, "day")} ago`;
}

// ---- To link ----

export type ReviewKind = "paid_by_me" | "multi_payer" | "settle_out" | "settle_in";

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  group_name: string;
  booking_date: string;
  description: string;
  cost: number;
  my_share: number;
  my_paid: number;
  currency: string;
  rejected_entry_references: Array<string>;
  /** A settle-up's other person, as Splitwise names them (backend sends null for expenses). */
  counterparty?: string | null;
}

export const KIND_LABEL: Record<ReviewKind, string> = {
  paid_by_me: "You paid",
  multi_payer: "Several payers",
  settle_out: "Settle-up you paid",
  settle_in: "Settle-up you received",
};

/** Only an expense I paid can count as spending without a bank payment. */
export const canCount = (kind: ReviewKind) => kind === "paid_by_me" || kind === "multi_payer";

/** Money in for a settle-up I received, money out for everything else. */
export const directionOf = (kind: ReviewKind): BankTx["direction"] =>
  kind === "settle_in" ? "CRDT" : "DBIT";

/** The newest pending items (at most 500), and how many are pending in all. */
/** For the nav badge: how many expenses wait on To link, as a head-only count (no rows). */
export const REVIEW_COUNT_KEY = [...REVIEW_KEY, "count"];

/**
 * The number of pending To link items. An older backend without the table has nothing waiting:
 * 0, not an error, so the badge stays quietly off and nothing retries.
 */
export async function fetchReviewCount(): Promise<number> {
  const { error, count } = await supabase
    .from("splitwise_review")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (error?.code === "PGRST205" || error?.code === "42P01") return 0;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function fetchReview(): Promise<{ items: Array<ReviewItem>; total: number }> {
  const { data, error, count } = await supabase
    .from("splitwise_review")
    .select(
      "id,kind,group_name,booking_date,description,cost,my_share,my_paid,currency,rejected_entry_references,counterparty",
      { count: "exact" },
    )
    .eq("status", "pending")
    .order("booking_date", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  const items = (data ?? []) as Array<ReviewItem>;
  return { items, total: count ?? items.length };
}

const cents = (amount: number) => Math.round(amount * 100);

/**
 * An item in the shape the CSV import's bank matcher reads. What left (or reached) the bank is
 * what I paid; a settle-up I received paid nothing, so its whole amount. Several payers match like
 * an expense I paid.
 */
export function reviewRow(item: ReviewItem, index: number): ClassifiedRow {
  const paid = canCount(item.kind);
  const amount = item.my_paid > 0 ? item.my_paid : item.cost;
  return {
    row: index + 1,
    date: item.booking_date,
    description: item.description,
    category: "",
    costCents: cents(amount),
    currency: item.currency,
    netCents: [],
    kind: paid ? "paid_by_me" : item.kind === "settle_in" ? "settle_in" : "settle_out",
    myNetCents: 0,
    shareCents: paid ? cents(item.my_share) : null,
  };
}

// Lower case, accents off, split on anything not a letter or digit.
const words = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);

export interface Suggestion {
  tx: BankTx;
  /** "likely": one clear match. "ambiguous": the user should look twice. */
  confidence: "likely" | "ambiguous";
}

/**
 * One suggested bank transaction per item, at most, never one the user rejected for it, and
 * never the same transaction for two items.
 */
export function suggestMatches(
  items: Array<ReviewItem>,
  bank: Array<BankTx>,
  rate: RateToEur,
): Map<string, Suggestion> {
  const rows = items.map(reviewRow);
  const byKey = new Map(bank.map((t) => [`${t.accountUid}|${t.entryReference}`, t]));
  const rejected = (r: ClassifiedRow, tx: BankTx) =>
    items[r.row - 1]!.rejected_entry_references.includes(tx.entryReference);
  const names = items.map((i) => words(i.counterparty ?? ""));
  // Every word of the other person's name (two letters or more) is in the bank's name for it.
  const named = (r: ClassifiedRow, tx: BankTx) => {
    const want = names[r.row - 1] ?? [];
    const have = new Set(words(tx.name ?? ""));
    return want.length > 0 && want.every((w) => have.has(w));
  };
  const out = new Map<string, Suggestion>();
  for (const m of matchBank(rows, bank, rate, rejected, named)) {
    const tx = byKey.get(`${m.accountUid}|${m.entryReference}`);
    if (tx) out.set(items[m.row - 1]!.id, { tx, confidence: m.confidence });
  }
  return out;
}

export type ReviewAction =
  | { action: "link"; id: string; tx: Pick<BankTx, "accountUid" | "entryReference"> }
  | { action: "reject"; id: string; entryReference: string }
  | { action: "count"; id: string }
  | { action: "dismiss"; id: string };

/** Runs one review action as the signed-in user; throws the database's message. */
export async function runReviewAction(a: ReviewAction): Promise<void> {
  const { error } =
    a.action === "link"
      ? await supabase.rpc("link_splitwise_review", {
          p_id: a.id,
          p_account_uid: a.tx.accountUid,
          p_entry_reference: a.tx.entryReference,
        })
      : a.action === "reject"
        ? await supabase.rpc("reject_splitwise_match", {
            p_id: a.id,
            p_entry_reference: a.entryReference,
          })
        : a.action === "count"
          ? await supabase.rpc("count_splitwise_review", { p_id: a.id })
          : await supabase.rpc("dismiss_splitwise_review", { p_id: a.id });
  if (error) throw new Error(error.message);
}
