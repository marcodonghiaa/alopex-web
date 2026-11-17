// The small CSV helpers every broker parser shares.
import { isDay } from "@/lib/date";
import { netShares } from "@/lib/trades";
import type { Trade } from "@/lib/trades";

/** Not in your holdings and not fully sold: there's no price to value what's left, so leave it out. */
export function unheldKeys(trades: Array<Trade>, knownKeys: Set<string>): Array<string> {
  return [...new Set(trades.map((t) => t.key))].filter(
    (key) =>
      !knownKeys.has(key) && Math.abs(netShares(trades.filter((t) => t.key === key))) > 0.000001,
  );
}

export function splitLine(line: string, separator: string): Array<string> {
  const cells: Array<string> = [];
  let cell = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === separator && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

export function parseDate(text: string): string | null {
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const iso = dayFirst
    ? `${dayFirst[3]}-${dayFirst[2]!.padStart(2, "0")}-${dayFirst[1]!.padStart(2, "0")}`
    : text;
  // Rejects 31/02/2026, which Date would roll into March.
  return isDay(iso) ? iso : null;
}
