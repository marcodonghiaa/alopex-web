import { dateLocale } from "@/lib/locale";
import { formatMoney } from "@/lib/transactions";

// Display helpers for the Splitwise import screens.

/** "3 Nov" (in the chosen locale): short and readable; the year only shows when it is not this year. */
export function shortDate(iso: string, today = new Date()): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getUTCFullYear() === today.getUTCFullYear();
  return d.toLocaleDateString(dateLocale(), {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** An amount in the chosen locale's format: "€12.34", "12,34 €". A code Intl rejects stays as text. */
export const moneyAmount = formatMoney;

export const moneyFromCents = (cents: number, currency: string) =>
  moneyAmount(cents / 100, currency);

const expenses = (n: number) => (n === 1 ? "1 expense" : `${n} expenses`);

/** The toast after an import: what was written, and how many of those you paid yourself. */
export function importedMessage(done: { shares: number; paidByYou: number; group: string }) {
  const head = `${expenses(done.shares)} imported into ${done.group}`;
  if (done.paidByYou <= 0 || done.paidByYou > done.shares) return head;
  if (done.paidByYou === done.shares) return `${head}, all paid by you`;
  return `${head}: ${done.shares - done.paidByYou} paid by others, ${done.paidByYou} paid by you`;
}
