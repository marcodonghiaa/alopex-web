import { supabase } from "@/integrations/supabase/client";
import type { GroupSummary } from "@/lib/import/splitwise-balances";
import { NO_NAME, type SplitPerson } from "@/lib/splits";
import type { TxKey } from "@/lib/transactions";

/** A recent incoming payment nobody has checked yet (see payback_candidates in the backend). */
export interface PaybackCandidate extends TxKey {
  booking_date: string;
  amount: number;
  currency: string;
  amount_eur: number | null;
  payer: string | null;
  /** The contact this payer was linked to the last time you confirmed one of their payments. */
  linked_contact: string | null;
}

/** Someone who owes you money right now, from split bills and Splitwise, in euros. */
export interface Debtor {
  name: string;
  open: number;
  /** The part of `open` that is a Splitwise balance (settled in Splitwise, not here). */
  onSplitwise: number;
  /** Only a Splitwise balance: Alopex has no bills of theirs to settle. */
  splitwiseOnly: boolean;
}

type SuggestReason = "linked" | "name" | "amount";

export interface PaybackSuggestion {
  payment: PaybackCandidate;
  debtor: Debtor;
  reason: SuggestReason;
}

const CANDIDATE_DAYS = 60;

export async function fetchPaybackCandidates(): Promise<Array<PaybackCandidate>> {
  const { data, error } = await supabase.rpc("payback_candidates", { p_days: CANDIDATE_DAYS });
  if (error) throw error;
  return (data ?? []) as Array<PaybackCandidate>;
}

/**
 * Everyone who owes you, once per name (case-insensitive): open split bills plus what Splitwise
 * says they owe you. Splitwise amounts without a euro rate are left out.
 */
export function debtorsFrom(
  people: Array<SplitPerson>,
  groups: Array<GroupSummary>,
  rate: (currency: string) => number | null,
): Array<Debtor> {
  const byName = new Map<string, Debtor & { fromSplits: boolean }>();
  const add = (name: string, value: number, fromSplits: boolean) => {
    const sw = fromSplits ? 0 : value;
    const key = name.trim().toLowerCase();
    // The server records names up to 100 characters (record_payback): longer ones can't be asked.
    if (!key || [...name.trim()].length > 100) return;
    const hit = byName.get(key);
    if (hit) {
      hit.open += value;
      hit.onSplitwise += sw;
      hit.fromSplits ||= fromSplits;
    } else
      byName.set(key, {
        name: name.trim(),
        open: value,
        onSplitwise: sw,
        splitwiseOnly: false,
        fromSplits,
      });
  };
  // Bills with no name ("Not assigned") have nobody to pay them back.
  for (const p of people) if (p.open > 0 && p.name !== NO_NAME) add(p.name, p.open, true);
  for (const g of groups) {
    const r2e = rate(g.currency);
    if (r2e === null) continue;
    for (const p of g.people) if (p.owesYou) add(p.person, Math.abs(p.balance) * r2e, false);
  }
  return [...byName.values()]
    .map(({ fromSplits, ...d }) => ({
      ...d,
      open: Math.round(d.open * 100) / 100,
      onSplitwise: Math.round(d.onSplitwise * 100) / 100,
      splitwiseOnly: !fromSplits,
    }))
    .filter((d) => d.open >= 0.01)
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
}

// Lower case, no accents, words only: "Mario  VÈRDI." → ["mario", "verdi"].
const words = (name: string): Array<string> =>
  name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// Legal forms: a payer with one of these is a company, never a friend paying you back. Dotted
// forms ("S.r.l.") come apart into letters, so runs of single letters are joined before the check.
const COMPANY = new Set([
  "srl",
  "srls",
  "spa",
  "snc",
  "sas",
  "sapa",
  "scarl",
  "gmbh",
  "kg",
  "ag",
  "ug",
  "ltd",
  "llc",
  "plc",
  "inc",
  "corp",
  "co",
  "sarl",
  "bv",
  "nv",
  "slu",
  "lda",
  "kft",
  "sro",
]);
const isCompany = (p: Array<string>): boolean => {
  const joined: Array<string> = [];
  let run = "";
  for (const w of [...p, ""]) {
    if (w.length === 1) run += w;
    else {
      if (run) joined.push(run);
      run = "";
      if (w) joined.push(w);
    }
  }
  return joined.some((w) => COMPANY.has(w));
};

/**
 * Whether the bank's payer name could be the contact you wrote down. Generous on purpose: it only
 * puts a question to you. Matches "Anna" to "Anna Rossi" (one word: a whole word of the payer's),
 * "Mar Verdi" to "Mario Verdi" (several words: each starts a different word of the payer's, 3+
 * letters, the whole word, or an initial next to a whole word), and run-together nicknames like "Marverdi" (the start of the first
 * name plus the surname). A company payer never matches.
 */
export function namesLookAlike(payer: string | null, contact: string): boolean {
  if (!payer) return false;
  const p = words(payer);
  const c = words(contact);
  if (p.length === 0 || c.length === 0 || isCompany(p)) return false;
  const used = new Set<number>();
  const several = c.length > 1;
  // An initial ("M. Verdi", "Luca M") stands for any word starting with it, but only next to a
  // word of 2+ letters that matched (whole, or as a 3+ letter start): "A R" alone is too little.
  const initial = (a: string, b: string) => a.length === 1 && b.startsWith(a);
  let whole = false;
  const allWords = c.every((w) => {
    const i = p.findIndex(
      (pw, idx) =>
        !used.has(idx) &&
        (pw === w ||
          (several && ((w.length >= 3 && pw.startsWith(w)) || initial(w, pw) || initial(pw, w)))),
    );
    if (i < 0) return false;
    used.add(i);
    whole ||= (p[i] ?? "").length > 1 && w.length > 1;
    return true;
  });
  if (allWords && whole) return true;
  const nick = c[0];
  if (several || p.length < 2 || nick === undefined) return false;
  if (nick === p.join("")) return true;
  // First-name start + surname, either order of the payer's words ("Verdi Mario" too).
  const ends = [p[0] ?? "", p[p.length - 1] ?? ""];
  for (const [first, last] of [ends, [...ends].reverse()] as Array<[string, string]>) {
    if (last.length < 3 || !nick.endsWith(last)) continue;
    const head = nick.slice(0, nick.length - last.length);
    if (head.length >= 2 && first.startsWith(head)) return true;
  }
  return false;
}

const sameCents = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * The question to ask for each payment, best guess first: a payer you linked before (only while
 * that person still owes you), else a payer whose name looks like someone who owes you, else
 * someone who owes you exactly this amount (only when one person does). Payments with no guess
 * are left out: most incoming money is not a payback.
 */
export function suggestPaybacks(
  payments: Array<PaybackCandidate>,
  debtors: Array<Debtor>,
): Array<PaybackSuggestion> {
  const find = (name: string) =>
    debtors.find((d) => d.name.toLowerCase() === name.trim().toLowerCase());
  const out: Array<PaybackSuggestion> = [];
  // One question per person at a time, about their newest payment: two at once could ask about
  // more than they owe. The next shows once that one is answered.
  const asked = new Set<string>();
  const add = (s: PaybackSuggestion) => {
    if (asked.has(s.debtor.name)) return;
    asked.add(s.debtor.name);
    out.push(s);
  };
  const newestFirst = [...payments].sort((a, b) => b.booking_date.localeCompare(a.booking_date));
  for (const payment of newestFirst) {
    if (payment.linked_contact) {
      const debtor = find(payment.linked_contact);
      if (debtor) add({ payment, debtor, reason: "linked" });
      continue;
    }
    const byName = debtors.filter((d) => namesLookAlike(payment.payer, d.name));
    if (byName.length > 0) {
      // Several look alike: the one whose debt is closest to the amount.
      const amount = payment.amount_eur ?? 0;
      const [best] = [...byName].sort(
        (a, b) => Math.abs(a.open - amount) - Math.abs(b.open - amount),
      );
      if (best) add({ payment, debtor: best, reason: "name" });
      continue;
    }
    if (payment.amount_eur === null) continue;
    const byAmount = debtors.filter((d) => sameCents(d.open, payment.amount_eur as number));
    const [only] = byAmount;
    if (only && byAmount.length === 1) add({ payment, debtor: only, reason: "amount" });
  }
  return out;
}

export interface PaybackResult {
  settled: Array<string>;
  settled_eur: number;
  left_eur: number | null;
  linked: boolean;
}

/** What happened, in one sentence for the toast. */
export function paybackMessage(
  name: string,
  result: PaybackResult,
  splitwiseOnly: boolean,
  money: (eur: number) => string,
): string {
  const n = result.settled.length;
  if (n === 0)
    return splitwiseOnly
      ? `Marked as ${name} paying you back. Record it in Splitwise too.`
      : `Marked as ${name} paying you back. No bill was fully covered, so none was settled.`;
  const bills = n === 1 ? "1 bill" : `${n} bills`;
  const left =
    result.left_eur && result.left_eur >= 0.01 ? `, ${money(result.left_eur)} left over` : "";
  return `${name} paid you back: ${bills} settled${left}.`;
}

/** The toast after "Not a payback" (or "Not Anna" on a payer you had linked). */
export const dismissMessage = (name: string, linked: boolean): string =>
  linked
    ? `Got it: not ${name}. This payer is no longer linked to them.`
    : "Got it: not a payback.";

/** What they owe you, in the parts the page shows: "€256.00 in bills + €30.50 on Splitwise". */
export function owesLine(d: Debtor, money: (eur: number) => string): string {
  const bills = Math.round((d.open - d.onSplitwise) * 100) / 100;
  if (d.onSplitwise < 0.01) return `owes you ${money(d.open)}`;
  if (bills < 0.01) return `owes you ${money(d.onSplitwise)} on Splitwise`;
  return `owes you ${money(bills)} in bills + ${money(d.onSplitwise)} on Splitwise`;
}
