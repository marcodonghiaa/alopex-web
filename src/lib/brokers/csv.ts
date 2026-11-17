// The small CSV helpers every broker parser shares.
import { netShares } from "@/lib/trades";
import type { Trade } from "@/lib/trades";

/** Not in your holdings and not fully sold: there's no price to value what's left, so leave it out. */
export function unheldKeys(trades: Array<Trade>, knownKeys: Set<string>): Array<string> {
  return [...new Set(trades.map((t) => t.key))].filter(
    (key) =>
      !knownKeys.has(key) && Math.abs(netShares(trades.filter((t) => t.key === key))) > 0.000001,
  );
}

/** The file's rows, without blank ones. A line break inside quotes stays in its cell. */
export function csvLines(text: string): Array<string> {
  const lines: Array<string> = [];
  let line = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (line.trim() !== "") lines.push(line);
      line = "";
    } else line += ch;
  }
  if (line.trim() !== "") lines.push(line);
  return lines;
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const parsed = new Date(`${iso}T00:00:00Z`);
  // Rejects 31/02/2026, which Date would roll into March.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}
