/** Holdings worth under this (EUR) sit behind a "Show N small balances" link. */
export const SMALL_BALANCE_EUR = 1;

/** Splits off holdings worth under €1, keeping order. If every one is small, shows them all. */
export function splitSmallBalances<T extends { valueEur: number }>(items: Array<T>) {
  const shown = items.filter((i) => i.valueEur >= SMALL_BALANCE_EUR);
  if (shown.length === 0) return { shown: items, small: [] as Array<T> };
  return { shown, small: items.filter((i) => i.valueEur < SMALL_BALANCE_EUR) };
}
